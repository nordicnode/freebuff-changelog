# Security policy

## Supported versions

The site is a static build redeployed from `main`; only the latest deploy is
supported. If you see a problem on the live site, it is current.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Instead:

- Use GitHub's **Report a vulnerability** (Security tab → Advisories) on this
  repo, or
- Contact [@nordicnode](https://github.com/nordicnode) directly on GitHub.

Past work here has included a real XSS sink in the generator's HTML escaping,
so reports about escaping, injection, or untrusted-data handling are taken
seriously and fixed visibly.

## Scope notes

- The site serves static files. There are no user accounts, sessions, or
  stored personal data.
- LLM provider keys live in GitHub Actions secrets and the Worker environment,
  never in the repo. If you find a leaked credential, report it the same way
  and it will be rotated.
- The `Ask the AI` endpoint is rate-limited per IP and grounded against stored
  diffs; model output is untrusted by design.
