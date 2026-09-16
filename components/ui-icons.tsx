import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" fill="none" focusable="false" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      {children}
    </svg>
  );
}

export function BucketIcon(props: IconProps) {
  return <Icon data-testid="bucket-icon" {...props}><path d="m4 8.5 8-4.5 8 4.5v8L12 21l-8-4.5v-8Z" /><path d="m4 8.5 8 4.5 8-4.5" /></Icon>;
}

export function FolderIcon(props: IconProps) {
  return <Icon {...props}><path d="M3.5 7.5h6l1.8 2h9.2v7.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z" /><path d="M3.5 10h17" /></Icon>;
}

export function UploadIcon(props: IconProps) {
  return <Icon {...props}><path d="M12 15V3" /><path d="m7.5 7.5 4.5-4.5 4.5 4.5" /><path d="M5 14v5h14v-5" /></Icon>;
}

export function DownloadIcon(props: IconProps) {
  return <Icon {...props}><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 16v5h14v-5" /></Icon>;
}

export function EyeIcon(props: IconProps) {
  return <Icon {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Icon>;
}

export function RefreshIcon(props: IconProps) {
  return <Icon {...props}><path d="M19.2 8A7.6 7.6 0 0 0 5 7l-1.5 2.5" /><path d="M3.5 5.5V9.5h4" /><path d="M4.8 16A7.6 7.6 0 0 0 19 17l1.5-2.5" /><path d="M20.5 18.5v-4h-4" /></Icon>;
}

export function ArchiveIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 5h16v4H4z" /><path d="M6 9h12v10H6z" /><path d="M10 13h4" /></Icon>;
}

export function SearchIcon(props: IconProps) {
  return <Icon {...props}><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></Icon>;
}

export function ChevronLeftIcon(props: IconProps) {
  return <Icon {...props}><path d="m14.5 5-7 7 7 7" /></Icon>;
}

export function CloseIcon(props: IconProps) {
  return <Icon {...props}><path d="m6 6 12 12" /><path d="m18 6-12 12" /></Icon>;
}

export function SignOutIcon(props: IconProps) {
  return <Icon {...props}><path d="M10 5H5v14h5" /><path d="M13 8l4 4-4 4" /><path d="M9 12h8" /></Icon>;
}

export function TrashIcon(props: IconProps) {
  return <Icon {...props}><path d="M4.5 7h15" /><path d="M9 7V4.5h6V7" /><path d="m6.5 7 .8 12h9.4l.8-12" /><path d="M10 10.5v5" /><path d="M14 10.5v5" /></Icon>;
}
