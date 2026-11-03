<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { yaml } from '@codemirror/lang-yaml';
import { tags as t } from '@lezer/highlight';

/**
 * A code editor for files the user edits in DoCatz (the compose file first): CodeMirror 6 with YAML colours, line
 * numbers, folding, undo, Tab to indent, and Find & Replace (Cmd/Ctrl+F; the panel has Replace and Replace all, case,
 * regexp and whole-word switches). Dark in both themes, in the colours of the container logs (.log-editor).
 * `save` fires on Cmd/Ctrl+S.
 */
const model = defineModel<string>({ required: true });
const emit = defineEmits<{ save: [] }>();

const host = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;

// the log editor's colours (main.css .lg-*), so code reads the same everywhere in DoCatz
const colours = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'oklch(78% 0.12 300)' },
  { tag: [t.string, t.special(t.string)], color: 'oklch(80% 0.12 145)' },
  { tag: [t.number, t.bool, t.null], color: 'oklch(80% 0.12 65)' },
  { tag: [t.comment, t.lineComment], color: 'oklch(62% 0.03 260)', fontStyle: 'italic' },
  { tag: [t.keyword, t.atom, t.labelName], color: 'oklch(78% 0.11 230)' },
  { tag: [t.meta, t.punctuation, t.separator, t.squareBracket, t.brace], color: 'oklch(70% 0.02 260)' },
  { tag: t.invalid, color: 'oklch(70% 0.19 25)' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'oklch(19% 0.014 260)', color: 'oklch(88% 0.01 260)', borderRadius: '12px' },
    '&.cm-focused': { outline: '2px solid color-mix(in oklch, var(--color-primary) 55%, transparent)', outlineOffset: '0' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55', borderRadius: '12px' },
    '.cm-content': { padding: '10px 0', caretColor: 'var(--color-primary)' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'oklch(60% 0.015 260 / 0.55)', paddingLeft: '6px' },
    '.cm-activeLine': { backgroundColor: 'oklch(100% 0 0 / 0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'oklch(80% 0.02 260)' },
    '.cm-cursor': { borderLeftColor: 'var(--color-primary)', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklch, var(--color-primary) 30%, transparent) !important' },
    '.cm-selectionMatch': { backgroundColor: 'oklch(100% 0 0 / 0.08)' },
    '.cm-searchMatch': { backgroundColor: 'oklch(80% 0.15 85 / 0.25)', outline: '1px solid oklch(80% 0.15 85 / 0.5)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'oklch(80% 0.15 85 / 0.5)' },
    '.cm-foldGutter span': { color: 'oklch(60% 0.015 260 / 0.6)' },
    // Find & Replace, in DoCatz's own look
    '.cm-panels': { backgroundColor: 'oklch(23% 0.016 260)', color: 'oklch(88% 0.01 260)', borderRadius: '12px 12px 0 0' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid oklch(100% 0 0 / 0.08)' },
    // two rows (Find …, then Replace …), as CodeMirror lays them out; the app's own font, not the code's
    '.cm-panel.cm-search': { padding: '8px 40px 8px 10px', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: '12px', lineHeight: '2.4' },
    '.cm-panel.cm-search > *': { verticalAlign: 'middle', margin: '0 6px 0 0' },
    '.cm-panel.cm-search input.cm-textfield': { backgroundColor: 'oklch(17% 0.012 260)', color: 'inherit', border: '1px solid oklch(100% 0 0 / 0.12)', borderRadius: '8px', padding: '3px 8px', fontSize: '12px', width: '16rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
    '.cm-panel.cm-search input.cm-textfield:focus': { outline: '2px solid color-mix(in oklch, var(--color-primary) 55%, transparent)' },
    '.cm-panel.cm-search button.cm-button': { backgroundImage: 'none', backgroundColor: 'oklch(100% 0 0 / 0.07)', color: 'inherit', border: 'none', borderRadius: '8px', padding: '4px 10px', fontSize: '12px', textTransform: 'capitalize', cursor: 'pointer' },
    '.cm-panel.cm-search button.cm-button:hover': { backgroundColor: 'oklch(100% 0 0 / 0.13)' },
    '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', opacity: '0.8', textTransform: 'capitalize', whiteSpace: 'nowrap' },
    '.cm-panel.cm-search [name=close]': { color: 'inherit', fontSize: '16px', opacity: '0.6', cursor: 'pointer', right: '8px', top: '6px' },
  },
  { dark: true },
);

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        yaml(),
        syntaxHighlighting(colours),
        theme,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (emit('save'), true) },
          // Cmd/Ctrl+H (and Alt+Cmd+F on a Mac) opens the panel with Replace, as editors do
          { key: 'Mod-h', preventDefault: true, run: openSearchPanel },
          { key: 'Mod-Alt-f', preventDefault: true, run: openSearchPanel },
          ...searchKeymap,
          ...foldKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) model.value = u.state.doc.toString();
        }),
        EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      ],
    }),
  });
});

// a new text from outside (another file opened, the AI draft taken): replace the editor's content
watch(model, (v) => {
  if (view && v !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
});

onBeforeUnmount(() => view?.destroy());

/** Find & Replace from a button (the panel opens with the selection, or the last search). */
function find() {
  if (view) {
    openSearchPanel(view);
  }
}
/** Whether Escape belongs to the editor (its search panel is open): the dialog then does not close. */
const searching = () => !!view?.dom.querySelector('.cm-search');
defineExpose({ find, searching, focus: () => view?.focus() });
</script>

<template>
  <div ref="host" class="code-editor selectable h-full min-h-0 overflow-hidden rounded-xl" />
</template>
