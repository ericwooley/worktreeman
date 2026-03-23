import { useEffect, useRef } from "react";
import { Editor } from "@toast-ui/react-editor";
import "@toast-ui/editor/dist/toastui-editor.css";
import { useTheme } from "./theme-provider";

interface ToastEditorHandle {
  getInstance(): {
    getMarkdown(): string;
    setMarkdown(markdown: string, cursorToEnd?: boolean): void;
  };
}

interface ProjectManagementWysiwygProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
}

export function ProjectManagementWysiwyg({
  value,
  onChange,
  height = "65vh",
}: ProjectManagementWysiwygProps) {
  const { theme } = useTheme();
  const editorRef = useRef<ToastEditorHandle | null>(null);
  const lastValueRef = useRef(value);

  useEffect(() => {
    const instance = editorRef.current?.getInstance();
    if (!instance || value === lastValueRef.current) {
      return;
    }

    instance.setMarkdown(value, false);
    lastValueRef.current = value;
  }, [value]);

  return (
    <div
      className={`pm-wysiwyg-shell border theme-border-subtle ${theme.variant === "dark" ? "pm-wysiwyg-shell-dark" : "pm-wysiwyg-shell-light"}`}
      data-theme-variant={theme.variant}
    >
      <Editor
        ref={editorRef as never}
        initialValue={value}
        previewStyle="vertical"
        height={height}
        initialEditType="wysiwyg"
        useCommandShortcut
        hideModeSwitch
        onChange={() => {
          const nextValue = editorRef.current?.getInstance().getMarkdown() ?? "";
          lastValueRef.current = nextValue;
          onChange(nextValue);
        }}
      />
    </div>
  );
}
