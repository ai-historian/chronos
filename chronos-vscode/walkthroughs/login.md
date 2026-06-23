# Connect an AI provider

Chronos works with any provider `pi` supports — **Anthropic, Google, OpenAI**,
and more. No provider is hardcoded.

The easiest way: click **Log in** in the Chronos panel header and follow the
prompt. Your key is written to `.chronos/.env` in the workspace as a
`<PROVIDER>_API_KEY` (for example `ANTHROPIC_API_KEY=…`).

You can also:

- Run **Chronos: Connect AI Provider (Log In)** from the Command Palette while a
  session is open.
- Edit `.chronos/.env` directly.

The checkmark appears once a provider key is present in the workspace.
