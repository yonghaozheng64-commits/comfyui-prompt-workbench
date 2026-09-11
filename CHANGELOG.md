# Changelog

## 0.2.0

- Extract state, storage, backup, locale, batch planning and backend status modules.
- Add Chinese/English UI selection and portable state backups.
- Save template snapshots and separators with batch presets.
- Preserve paused state across execution events and check pause after asynchronous operations.
- Preserve intentionally empty selections during legacy state migration.
- Avoid startup panel prebuilding and hidden-tab queue polling; disconnect sidebar observers.
- Support backends without mapped history; distinguish failed execution from success.
- Add dependency-free regression tests and CI configuration.
- Exclude personal migration assets from source control and remove automatic bundled migration.
