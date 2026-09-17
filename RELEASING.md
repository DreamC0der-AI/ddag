# Releasing

A release is a tag. CI publishes it; nobody types a code.

1. Work lands on `main` with the version set in `package.json`,
   `package-lock.json` and `plugin/.claude-plugin/plugin.json`.
2. Mark the version on the chain after the commit (`version_mark vX.Y.Z`).
3. Push the tag `vX.Y.Z` on the published commit. The **Publish to npm**
   workflow (`.github/workflows/publish.yml`) then refuses a tag that does not
   match `package.json`, runs `npm ci`, the typecheck and the whole test suite,
   and runs `npm publish`. `prepublishOnly` builds the bundles.
4. Judge the publish target's leaves on the chain: the GitHub tree, the npm
   tarball's bytes against a local build of the marked commit, the plugin
   listing.

Publishing uses npm **trusted publishing**: npm trusts this repository's
`publish.yml` through OIDC, so no npm token exists in the repository or its
settings, and every published version carries a provenance attestation naming
the commit it was built from. The one-time setup is on npmjs.com, under the
package's Settings, Trusted Publisher: GitHub Actions, organization or user
`DreamC0der-AI`, repository `ddag`, workflow filename `publish.yml`.

To rehearse without publishing, run the workflow by hand from the Actions tab
with "dry run" checked: it does everything and ends with
`npm publish --dry-run`.
