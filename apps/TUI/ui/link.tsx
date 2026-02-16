import { useTheme } from "../context/theme";

export function Link(props: { href: string; children?: any }) {
  const theme = useTheme();

  return (
    <text fg={theme.markdownLink} attributes={1 /* underline */}>
      {props.children ?? props.href}
    </text>
  );
}
