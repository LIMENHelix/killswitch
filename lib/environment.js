// Preview deployments share code but must not share the production blast
// radius. Live provider writes are disabled in Vercel previews unless an
// operator explicitly opts a deployment in.
export function externalSideEffectsAllowed() {
  return process.env.VERCEL_ENV !== 'preview' || process.env.KS_ALLOW_PREVIEW_SIDE_EFFECTS === '1';
}
