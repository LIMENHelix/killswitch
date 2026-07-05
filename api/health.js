// Minimal health endpoint — satisfies the project's "api/**" functions config.
// The site itself is fully static (web3forms + open-meteo + client-side chat),
// so this is just a no-op so the build's functions pattern matches.
export default function handler(req, res) {
  res.status(200).json({ ok: true, service: 'killswitch' });
}
