import type { FormEventHandler, HTMLAttributes, KeyboardEventHandler, ReactNode, RefObject } from "react";

import { CornerDownLeftIcon, SquareIcon } from "lucide-react";

import { designTokens } from "../../lib/designTokens";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

type PromptInputRootProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputRoot({ className, ...props }: PromptInputRootProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-3xl rounded-2xl p-3 shadow-[0_10px_25px_rgba(0,0,0,0.06)]",
        designTokens.classes.panelSurface,
        className,
      )}
      {...props}
    />
  );
}

type PromptInputFormProps = {
  className?: string;
  onSubmit: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
};

export function PromptInputForm({ className, onSubmit, children }: PromptInputFormProps) {
  return (
    <form className={cn("flex items-end gap-3", className)} onSubmit={onSubmit}>
      {children}
    </form>
  );
}

type PromptInputTextareaProps = {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
};

export function PromptInputTextarea({
  value,
  placeholder,
  disabled,
  onChange,
  onKeyDown,
  textareaRef,
}: PromptInputTextareaProps) {
  return (
    <Textarea
      ref={textareaRef}
      className="max-h-60 min-h-10 flex-1 resize-none border-none bg-transparent p-2 shadow-none focus-visible:ring-0"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      aria-label="Message input"
    />
  );
}

type PromptInputSubmitProps = {
  busy: boolean;
  disabled?: boolean;
  onStop: () => void;
};

export function PromptInputSubmit({ busy, disabled, onStop }: PromptInputSubmitProps) {
  if (busy) {
    return (
      <Button type="button" size="icon" variant="destructive" className="rounded-full" onClick={onStop} aria-label="Stop generating response">
        <SquareIcon className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <Button type="submit" size="icon" className="rounded-full" disabled={disabled} aria-label="Send message">
      <CornerDownLeftIcon className="h-4 w-4" />
    </Button>
  );
}
