# Governance

This page describes the repository's operational roles. It does not assign a
legal role, create a statutory open-source software steward designation, or
grant authority over credentials, customer data, publication, or live funds.

## Maintainers and contributors

Maintainers keep the SDK source, five language packages, shared catalogs,
documentation, repository controls, and release evidence coherent. They review
technical and security changes, respond to private reports, and coordinate
maintenance work with the relevant package or release owners.

Contributors propose focused changes with the affected package or document,
compatibility impact, tests or evidence, and any security or dependency context
needed for review. The [contribution guide](CONTRIBUTING.md) describes the
repository checks and the information useful for changes that affect package
licenses, dependencies, security-sensitive behavior, or release evidence.

## Review and release decisions

Technical and security decisions receive human review through the repository's
normal contribution process. Cross-language security and release changes also
receive an independent review before closure when the applicable workflow calls
for it.

Releases require explicit human approval. A maintainer or contributor role does
not by itself grant permission to push, create tags, publish packages, change
repository security settings, handle secrets, move funds, or disclose an
incident publicly. The release workflow's checked-in configuration is not a
standing delegation of those powers, and a documentation change does not
publish anything.

## Security and private records

Report suspected vulnerabilities through the [security policy](SECURITY.md).
Keep incident contacts, customer or victim context, private risk assessments,
authority correspondence, credentials, signing material, and provider review
records in company-controlled private systems. The public repository should
contain only the sanitized process and evidence needed for consumers and
contributors.

## Legal and evidence boundary

The repository copyright and [NOTICE](NOTICE) identify ELSOUL LABO B.V. as the
company associated with the repository's original SDK source and imported
hygiene tooling. That notice does not decide whether the company is a
manufacturer, open-source software steward, contributor, or another role under
any regulation. The applicable facts and support commitments remain open for a
responsible human to assess.

Public documentation describes the security process and links to release
evidence. This repository does not declare CRA conformity, CE marking, or
certification. See the [public compliance and evidence index](docs/compliance/README.md)
for dated technical evidence and its limits.

## Related documents

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Secret-exposure response](docs/secret-exposure-response.md)
- [Release verification](docs/verify-release.md)
- [License](LICENSE)
