function supportsFormElicitation(capabilities: unknown = {}): boolean {
  if (!isRecord(capabilities)) return false;
  const elicitation = capabilities.elicitation;
  if (!isRecord(elicitation)) return false;
  return Object.keys(elicitation).length === 0 || Boolean(elicitation.form);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export { supportsFormElicitation };
