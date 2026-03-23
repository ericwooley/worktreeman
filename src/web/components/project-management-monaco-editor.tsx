import Editor from "@monaco-editor/react";
import { useTheme } from "./theme-provider";

interface ProjectManagementMonacoEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
}

export function ProjectManagementMonacoEditor({
  value,
  onChange,
  height = "65vh",
}: ProjectManagementMonacoEditorProps) {
  const { theme } = useTheme();

  return (
    <Editor
      height={height}
      defaultLanguage="markdown"
      language="markdown"
      value={value}
      onChange={(nextValue) => onChange(nextValue ?? "")}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        wordWrap: "on",
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
      theme={theme.variant === "light" ? "vs" : "vs-dark"}
    />
  );
}
