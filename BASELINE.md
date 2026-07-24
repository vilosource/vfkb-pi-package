# Constructed upgrade baseline — NOT a shipped release

This branch exists solely as the "before" arm of `scenarios/install-path.mjs`.

The vfkb pi package has never been released, so there is no genuine prior version to
upgrade from. Rather than fabricate a release tag (which would pollute the release
history and imply something shipped that never did), this branch carries a real tree
with the **config resolver removed** — so an install from it genuinely delivers
session injection and **zero `kb_*` tools**, which is the capability difference the
upgrade arm must observe.

The upgrade path it exercises is real: `pi install git:…@baseline/pre-capability`
then re-resolve to `main`. Only the *provenance* of the baseline is constructed, and
the install-path record says so.

Do not install this branch. Do not tag it.
