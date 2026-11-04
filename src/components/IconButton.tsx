import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, children, className = "", ...props }: Props) {
  return (
    <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}
