# Locale Contributions

Locales live in `locale/*.json`. Each file must contain the same keys as `locale/en.json`.

## Add a language

1. Copy `locale/en.json` to `locale/<code>.json`.
2. Translate the `meta.title` and `meta.description` values.
3. Run `npm run validate:locales`.

## Validation

```bash
npm run validate:locales
```