# Cophyla release feed

Static, signed release entries per channel, OS and architecture: `<channel>/<os>-<arch>.json`.
The daemon verifies every entry against the release key shipped in the platform before it stages anything.
The artifacts are the assets of the `<component>-v<version>` releases in this repository.
