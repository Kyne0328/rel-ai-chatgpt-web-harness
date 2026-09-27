#!/usr/bin/env node
import * as path from 'node:path';
import { Command } from 'commander';
import { readConfig } from '../src/config.js';
import { installLocalExtension } from '../src/extensions/registry.js';
import {
  PUBLISHER_CATALOG_FILENAME,
  PUBLISHER_CONFIG_FILENAME,
  createPublisherExtension,
  initializePublisherRepository,
  normalizeExtensionSlug,
  syncPublisherRepository,
  validatePublisherRepository
} from '../src/extensions/authoring.js';

const program = new Command()
  .name('relai-extension')
  .description('Create and maintain a Rel.AI extension publisher monorepo.')
  .showHelpAfterError();

program
  .command('init [repository-path]')
  .description('Initialize one extension monorepo for a developer or organization.')
  .requiredOption('--namespace <namespace>', 'Global extension ID namespace, for example kyne.')
  .requiredOption('--publisher <name>', 'Publisher display name.')
  .requiredOption('--repository <url>', 'Public HTTPS Git repository URL.')
  .option('--publisher-url <url>', 'Publisher profile or organization URL.')
  .option('--raw-base-url <url>', 'HTTPS raw-content base URL. Inferred for GitHub repositories.')
  .option('--branch <branch>', 'Repository branch used for raw GitHub URLs.', 'main')
  .option('--force', `Replace existing ${PUBLISHER_CONFIG_FILENAME} publisher metadata.`)
  .action((repositoryPath = '.', options) => {
    const result = initializePublisherRepository(repositoryPath, {
      namespace: options.namespace,
      publisherName: options.publisher,
      publisherUrl: options.publisherUrl,
      repository: options.repository,
      rawBaseUrl: options.rawBaseUrl,
      branch: options.branch,
      force: options.force === true
    });
    console.log(`Initialized publisher monorepo at ${result.root}`);
    console.log(`Publisher config: ${PUBLISHER_CONFIG_FILENAME}`);
    console.log(`Development catalog: ${PUBLISHER_CATALOG_FILENAME}`);
  });

program
  .command('create <extension-name> [repository-path]')
  .description('Create an independently installable extension under extensions/<name>.')
  .option('--name <display-name>', 'Extension display name.')
  .option('--description <text>', 'Extension description.')
  .option('--kind <kind>', 'Extension kind: skill or cli.', 'skill')
  .option('--command <command>', 'Required local command for a CLI extension.')
  .action((extensionName, repositoryPath = '.', options) => {
    const result = createPublisherExtension(repositoryPath, extensionName, {
      name: options.name,
      description: options.description,
      kind: options.kind,
      command: options.command
    });
    console.log(`Created ${result.id} at ${result.directory}`);
    console.log(`Run "relai-extension sync ${repositoryPath}" after adding or changing package files.`);
  });

program
  .command('sync [repository-path]')
  .description('Synchronize publisher metadata, package file hashes, and the generated publisher catalog.')
  .action((repositoryPath = '.') => {
    const result = syncPublisherRepository(repositoryPath);
    console.log(`Synchronized ${result.manifests.length} extension${result.manifests.length === 1 ? '' : 's'}.`);
    console.log(`Updated ${PUBLISHER_CATALOG_FILENAME}.`);
  });

program
  .command('dev-install <extension-name> [repository-path]')
  .description('Validate and install one extension directly from this publisher repository for local development.')
  .option('--config <path>', 'Rel.AI config.json to use instead of the default configured profile.')
  .action(async (extensionName, repositoryPath = '.', options) => {
    const root = path.resolve(repositoryPath);
    const slug = normalizeExtensionSlug(extensionName);
    syncPublisherRepository(root);
    const validation = validatePublisherRepository(root);
    if (!validation.ok) throw new Error(validation.errors.join(' '));
    if (options.config) process.env.REL_AI_MCP_CONFIG = path.resolve(options.config);
    const installed = await installLocalExtension(readConfig(), path.join(root, 'extensions', slug));
    console.log(`Installed ${installed.id} ${installed.version} from local publisher sources.`);
    console.log('Run this command again after editing the extension; production catalog installs remain HTTPS-only.');
  });

program
  .command('validate [repository-path]')
  .description('Validate every extension, package hash, publisher identity, and generated catalog.')
  .action((repositoryPath = '.') => {
    const result = validatePublisherRepository(repositoryPath);
    if (result.ok) {
      console.log(`Validated ${result.extensions.length} extension${result.extensions.length === 1 ? '' : 's'} in ${result.root}.`);
      return;
    }
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  });

try {
  if (process.argv.length <= 2) program.help();
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
