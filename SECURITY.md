# Security

DoCatz runs on your computer with access to things that matter — a Linux VM with your home folder mounted, a Docker engine that can run anything, a local proxy, a certificate authority your browsers trust, and system changes made with your administrator password (port forwarding, a resolver). A security problem in it is taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately instead:

1. Open the repository's **Security** tab → **Report a vulnerability**
   ([direct link](https://github.com/catzoidhub/DoCatz/security/advisories/new)). Only the maintainer sees it.
2. Say what is affected, how to reproduce it, and what an attacker could do with it. A proof of concept helps.

Security reports are read before anything else, as soon as the maintainer can — there is no fixed response time yet.
Together we agree on a fix and when to publish it; you are credited in the advisory and the release notes unless you
would rather not be.

## What is in scope

- The DoCatz app and its updater (the update feed and the downloaded update are checked before they install).
- Anything that would let a web page, another app or a crafted file make DoCatz do something you did not ask for —
  deep links (`docatz://`), imported files, the local services it runs.
- Secrets leaving your computer: container environment values, the shared CA's private key, the AI key in the "Catzoid AI" Keychain item.
- The engine and its downloads — anything that gets a download past its pinned checksum, exposes the Docker socket or the proxy beyond this computer, or lets a docatz:// link run a compose file or a container without your click.

Out of scope: problems that need someone who already controls your Mac or your user account, and vulnerabilities in
third-party software DoCatz installs or talks to (report those upstream — we are happy to help).

## Supported versions

Only the **latest release** gets security fixes; the app updates itself, so please stay on it.
