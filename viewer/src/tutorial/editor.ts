/**
 * CodeMirror 6 래퍼 — 튜토리얼용 Python 에디터.
 *
 * 첫 단계(T3)에선 잠금 영역이 없어 단순한 편집 가능 영역만 노출. 향후 T5
 * (클래스 서브클래스 시나리오) 에서 잠금 영역이 필요해지면 이 래퍼에
 * transactionFilter 를 추가해 특정 line 범위 편집을 차단할 예정.
 */

import { python } from '@codemirror/lang-python';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';

export interface CodeEditorHandle {
  readonly element: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
  destroy(): void;
}

const DARK_THEME: Extension = EditorView.theme(
  {
    '&': {
      backgroundColor: 'rgba(10, 14, 24, 0.92)',
      color: '#e8eaf0',
      fontSize: '13.5px',
      fontFamily: 'Consolas, "Cascadia Code", "JetBrains Mono", Menlo, Monaco, ui-monospace, "Liberation Mono", "Courier New", monospace',
      height: '100%',
    },
    '.cm-content': {
      caretColor: '#ffb84d',
      padding: '12px 0',
    },
    '.cm-gutters': {
      backgroundColor: 'rgba(0, 0, 0, 0.18)',
      color: '#5a6072',
      border: 'none',
      paddingRight: '6px',
    },
    '.cm-activeLineGutter, .cm-activeLine': {
      backgroundColor: 'rgba(255, 184, 77, 0.06)',
    },
    '.cm-cursor': { borderLeftColor: '#ffb84d', borderLeftWidth: '2px' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(255, 184, 77, 0.22)' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(255, 184, 77, 0.28)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit' },
  },
  { dark: true },
);

export function createCodeEditor(initialValue: string): CodeEditorHandle {
  const element = document.createElement('div');
  element.className = 'maehwa-tutorial-editor';
  element.style.width = '100%';
  element.style.height = '100%';
  element.style.overflow = 'hidden';
  element.style.borderRadius = '10px';
  element.style.border = '1px solid rgba(255, 255, 255, 0.1)';

  const state = EditorState.create({
    doc: initialValue,
    extensions: [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      python(),
      // 학생들에게 4칸 들여쓰기로 가르치므로 에디터도 PEP 8 표준 4칸으로 통일.
      // (CodeMirror 6 기본은 2칸 — starter code 의 4칸과 어긋났음.)
      indentUnit.of('    '),
      EditorState.tabSize.of(4),
      DARK_THEME,
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({ state, parent: element });

  return {
    element,
    getValue: () => view.state.doc.toString(),
    setValue: (v: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: v },
      });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
