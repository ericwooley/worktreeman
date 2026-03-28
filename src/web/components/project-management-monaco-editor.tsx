import Editor from "@monaco-editor/react";
import { useTheme } from "./theme-provider";

interface ProjectManagementMonacoEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function ProjectManagementMonacoEditor({
  value,
  onChange,
  height = "65vh",
  readOnly = false,
  onFocus,
  onBlur,
}: ProjectManagementMonacoEditorProps) {
  const { theme } = useTheme();

  function handleMount(editor: any /* monaco.editor.IStandaloneCodeEditor */, monaco: any) {
    if (onFocus) editor.onDidFocusEditorWidget(onFocus);
    if (onBlur) editor.onDidBlurEditorWidget(onBlur);
  }

  return (
    <Editor
      height={height}
      defaultLanguage="markdown"
      language="markdown"
      value={value}
      onChange={(nextValue) => onChange(nextValue ?? "")}
      onMount={handleMount}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        wordWrap: "on",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        readOnly,
      }}
      theme={theme.variant === "light" ? "vs" : "vs-dark"}
    />
  );
}
