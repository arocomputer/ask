# Terminal design

Ask is the product name; `ask` remains the executable, path and compact command label.
The human CLI uses the terminal's foreground/background with bold emphasis and dim supporting
text. It never sets a background or a chromatic foreground. NO_COLOR removes emphasis; TERM=dumb
also disables interactive prompts. Machine JSON and piped TSV are independent of presentation.

## Layout

- Labels name actions; hints describe useful state, such as credential source or the current
  default. Avoid internal jargon in setup screens and duplicate completion messages. Enabling
  an integration is distinct from installing its application; removing a saved key does not
  remove credentials supplied through the environment.
- Compact sentence-case headings; general help opens with bold `Ask` and the muted tagline
  `Background tasks, handled.` on the same line. No repeated help boilerplate or decorative boxes.
- A screen heading supplies its context once: the settings hub omits a second title and
  navigation receipts, while action prompts retain their specific questions.
- A narrow `❙` bar marks focus; its exact dimensions depend on the terminal font.
  Only the focused item label is bold in a picker. Multiselect
  checkboxes represent membership, independently of focus. Hints appear below the list.
- Esc clears a filter or goes back. Enter confirms; completed actions save independently.
- Only lists with more than seven options accept filtering; short menus ignore typed text.
  This uses the original list size so narrowing search results does not disable search.
- Prompts omit keyboard-instruction footers. Supporting text describes the focused item or
  input state (defaults, character counts and hidden-key confirmation), rather than controls.
- Text fields show a tail preview and count; API keys show a fixed mask. Callback values are
  not retained in completed-prompt receipts. Login URLs remain intact for copying.
- Tables use columns when there is room and labeled records on phones. Prose wraps instead of
  truncating. Session outcomes precede activity. Progress is a stable label, not an animation.
- The active prompt owns its own screen region. A resize starts a fresh block rather than
  guessing which older lines were reflowed and erasing history.

## Offline visual fixtures

```sh
node test/fixtures/terminal.ts 80
node test/fixtures/terminal.ts 40
node test/fixtures/terminal.ts 32 plain
```

These call the actual command/prompt renderers using a disposable home and synthetic records.
They cover help, models, tools, sessions/results, legacy empty state, command errors, picker focus,
multiselect, empty filtering, callback/secret entry and doctor success/failure. No account or model
is contacted. Review in both light and dark terminal themes. `test/base/term.test.ts` protects
narrow layouts, monochrome emphasis, focus versus selection, secret masking and piped output.

For interaction checks, use a disposable ASK_HOME and a real 32-column PTY: navigate, filter,
paste, cancel a field, save a setting and return to the hub. Verify the cursor and terminal input
mode are restored on exit. Static fixtures do not replace these input checks.
