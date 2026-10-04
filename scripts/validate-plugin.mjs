import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_NAME_LENGTH, MIN_SKILL_DESCRIPTION_LENGTH, SKILL_NAME_PATTERN } from './skill-validation.mjs';

// Bundled OpenAI skills intentionally use the minimal name/description frontmatter profile.
const ALLOWED_SKILL_FRONTMATTER_FIELDS = new Set(['name', 'description']);

function validatePlugin(root) {
  const errors = [];
  const packageJson = readJson(path.join(root, 'package.json'), errors, 'package.json');
  const skills = validateSkills(root, './skills/', errors);

  if (errors.length) throw new Error(`Skill package validation failed:\n- ${errors.join('\n- ')}`);
  return {
    ok: true,
    name: packageJson?.name,
    version: packageJson?.version,
    skills
  };
}

function validateSkills(root, skillsPath, errors) {
  const relative = typeof skillsPath === 'string' ? skillsPath : './skills/';
  const skillRoot = path.resolve(root, relative);
  if (!fs.existsSync(path.join(skillRoot, 'PROVENANCE.md'))) errors.push('Skill package is missing skills/PROVENANCE.md.');
  const directories = fs.existsSync(skillRoot)
    ? fs.readdirSync(skillRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    : [];
  const skills = [];
  for (const directory of directories) {
    const rootForSkill = path.join(skillRoot, directory);
    const skillPath = path.join(rootForSkill, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const label = `skills/${directory}/SKILL.md`;
    const source = readText(skillPath, errors, label);
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatter) {
      errors.push(`${label} requires YAML frontmatter.`);
      continue;
    }
    const fields = [...frontmatter[1].matchAll(/^([A-Za-z0-9_-]+):/gm)].map(match => match[1]);
    if (!fields.includes('name') || !fields.includes('description')) errors.push(`${label} frontmatter requires name and description.`);
    if (fields.some(field => !ALLOWED_SKILL_FRONTMATTER_FIELDS.has(field))) {
      errors.push(`${label} bundled OpenAI frontmatter may contain only name and description.`);
    }
    const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
    const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
    if (name !== directory) errors.push(`${label} name must equal its directory.`);
    if (name.length < 1 || name.length > MAX_SKILL_NAME_LENGTH) errors.push(`${label} name must be 1-${MAX_SKILL_NAME_LENGTH} characters.`);
    if (!SKILL_NAME_PATTERN.test(name)) {
      errors.push(`${label} name must use lowercase letters, numbers, and single hyphens with no leading or trailing hyphen.`);
    }
    if (description.length < MIN_SKILL_DESCRIPTION_LENGTH || description.length > MAX_SKILL_DESCRIPTION_LENGTH) errors.push(`${label} description must be ${MIN_SKILL_DESCRIPTION_LENGTH}-${MAX_SKILL_DESCRIPTION_LENGTH} characters.`);
    const agentLabel = `skills/${directory}/agents/openai.yaml`;
    const agentPath = path.join(rootForSkill, 'agents', 'openai.yaml');
    const agent = parseOpenAiAgentMetadata(readText(agentPath, errors, agentLabel), errors, agentLabel);
    const skillInterface = agent?.interface;
    for (const field of ['display_name', 'short_description', 'default_prompt']) {
      if (typeof skillInterface?.[field] !== 'string' || !skillInterface[field].trim()) errors.push(`${agentLabel} interface.${field} must be a non-empty string.`);
    }
    if (typeof skillInterface?.default_prompt === 'string' && !skillInterface.default_prompt.includes(`$${directory}`)) {
      errors.push(`${agentLabel} interface.default_prompt must reference $${directory}.`);
    }
    skills.push(name);
  }
  if (!skills.includes('rel-ai-workflow')) errors.push('Skill package must include rel-ai-workflow.');
  const workflowRoot = path.join(skillRoot, 'rel-ai-workflow');
  const workflow = readText(path.join(workflowRoot, 'SKILL.md'), errors, 'skills/rel-ai-workflow/SKILL.md');
  for (const relativeReference of ['references/workflows.md', 'references/safety.md']) {
    if (!fs.existsSync(path.join(workflowRoot, relativeReference))) errors.push(`Core skill is missing ${relativeReference}.`);
  }
  if (!workflow.includes('references/workflows.md')) errors.push('Core SKILL.md must link references/workflows.md.');
  if (!workflow.includes('references/safety.md')) errors.push('Core SKILL.md must link references/safety.md.');
  return skills.sort();
}

function parseOpenAiAgentMetadata(source, errors, label) {
  if (!source) return null;
  const root = {};
  const seenRoot = new Set();
  const seenInterface = new Set();
  const seenDependencyKeys = new Set();
  let section = null;
  let dependencyTool = null;
  for (const [index, rawLine] of source.split('\n').entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const lineLabel = `${label} line ${index + 1}`;
    if (rawLine.includes('\t')) {
      errors.push(`${lineLabel} must use spaces, not tabs.`);
      continue;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();
    if (indent === 0) {
      const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
      if (!match) {
        errors.push(`${lineLabel} is not a supported YAML root mapping.`);
        continue;
      }
      const [, key, rawValue = ''] = match;
      if (seenRoot.has(key)) errors.push(`${label} has duplicate root key '${key}'.`);
      seenRoot.add(key);
      if (rawValue.trim()) errors.push(`${label} root key '${key}' must contain a nested mapping.`);
      section = key;
      dependencyTool = null;
      if (key === 'interface') root.interface = {};
      else if (key === 'dependencies') root.dependencies = { tools: [] };
      else errors.push(`${label} has unsupported root mapping '${key}'.`);
      continue;
    }

    if (section === 'interface') {
      if (indent !== 2) {
        errors.push(`${lineLabel} must be a two-space child of interface.`);
        continue;
      }
      const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
      if (!match) {
        errors.push(`${lineLabel} is not a supported interface mapping entry.`);
        continue;
      }
      const [, key, rawValue = ''] = match;
      if (seenInterface.has(key)) errors.push(`${label} interface has duplicate key '${key}'.`);
      seenInterface.add(key);
      root.interface[key] = parseYamlScalar(rawValue, errors, lineLabel);
      continue;
    }

    if (section === 'dependencies') {
      if (indent === 2) {
        const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
        if (!match) {
          errors.push(`${lineLabel} is not a supported dependencies mapping entry.`);
          continue;
        }
        const [, key, rawValue = ''] = match;
        if (key !== 'tools') errors.push(`${label} dependencies has unsupported field '${key}'.`);
        if (seenDependencyKeys.has(key)) errors.push(`${label} dependencies has duplicate key '${key}'.`);
        seenDependencyKeys.add(key);
        if (rawValue.trim()) errors.push(`${lineLabel} tools must contain a YAML list.`);
        dependencyTool = null;
        continue;
      }
      if (indent === 4 && trimmed.startsWith('- ')) {
        const match = /^-\s+([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
        if (!match) {
          errors.push(`${lineLabel} must begin a dependency tool mapping.`);
          continue;
        }
        dependencyTool = {};
        root.dependencies.tools.push(dependencyTool);
        const [, key, rawValue = ''] = match;
        dependencyTool[key] = parseYamlScalar(rawValue, errors, lineLabel);
        continue;
      }
      if (indent === 6 && dependencyTool) {
        const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
        if (!match) {
          errors.push(`${lineLabel} is not a supported dependency tool mapping entry.`);
          continue;
        }
        const [, key, rawValue = ''] = match;
        if (Object.hasOwn(dependencyTool, key)) errors.push(`${lineLabel} duplicates dependency field '${key}'.`);
        dependencyTool[key] = parseYamlScalar(rawValue, errors, lineLabel);
        continue;
      }
      errors.push(`${lineLabel} has unsupported dependencies indentation or list syntax.`);
      continue;
    }

    errors.push(`${lineLabel} is not inside a supported root mapping.`);
  }
  if (!root.interface) errors.push(`${label} must contain an interface root mapping.`);
  const interfaceKeys = Object.keys(root.interface || {});
  const allowedInterface = new Set(['display_name', 'short_description', 'default_prompt']);
  for (const key of interfaceKeys) if (!allowedInterface.has(key)) errors.push(`${label} has unsupported interface field '${key}'.`);

  const allowedDependencyFields = new Set(['type', 'value', 'description', 'transport', 'url']);
  for (const [index, dependency] of (root.dependencies?.tools || []).entries()) {
    const prefix = `${label} dependencies.tools[${index}]`;
    for (const key of Object.keys(dependency)) if (!allowedDependencyFields.has(key)) errors.push(`${prefix} has unsupported field '${key}'.`);
    if (dependency.type !== 'mcp') errors.push(`${prefix}.type must be 'mcp'.`);
    if (typeof dependency.value !== 'string' || !dependency.value.trim()) errors.push(`${prefix}.value must be a non-empty MCP tool/server identifier.`);
    for (const optional of ['description', 'transport', 'url']) {
      if (Object.hasOwn(dependency, optional) && (typeof dependency[optional] !== 'string' || !dependency[optional].trim())) {
        errors.push(`${prefix}.${optional} must be a non-empty string when present.`);
      }
    }
  }
  return root;
}

function parseYamlScalar(rawValue, errors, label) {
  const value = String(rawValue || '').trim();
  if (!value) {
    errors.push(`${label} requires a scalar value.`);
    return '';
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') throw new Error('quoted scalar is not a string');
      return parsed;
    } catch (error) {
      errors.push(`${label} has invalid double-quoted YAML scalar: ${error.message}`);
      return '';
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      errors.push(`${label} has an unterminated single-quoted YAML scalar.`);
      return '';
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  const comment = value.search(/\s+#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

function readJson(file, errors, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { errors.push(`${label} is missing or invalid JSON: ${error.message}`); return null; }
}
function readText(file, errors, label) {
  try { return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
  catch (error) { errors.push(`${label} is missing: ${error.message}`); return ''; }
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(validatePlugin(root), null, 2));
}

export { parseOpenAiAgentMetadata, validatePlugin };
