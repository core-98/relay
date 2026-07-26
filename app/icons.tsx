/** The line icons the Relay design uses, at the stroke weights it specifies. */

type IconProps = { size?: number; strokeWidth?: number };

function Icon({
  size = 16,
  strokeWidth = 2,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function LockIcon({ size = 14, strokeWidth = 2 }: IconProps) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <rect x="3" y="11" width="18" height="11" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Icon>
  );
}

export function PlusIcon({ size = 20 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Icon>
  );
}

export function ArrowRightIcon({ size = 15 }: IconProps) {
  return (
    <Icon size={size} strokeWidth={2.5}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Icon>
  );
}

export function CopyIcon({ size = 15 }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="8" y="8" width="14" height="14" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  );
}

export function AlertIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

export function ChevronDownIcon({ size = 13 }: IconProps) {
  return (
    <Icon size={size} strokeWidth={2.5}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function PlayIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

export function PauseIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

export function ExpandIcon({ size = 17 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </Icon>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

export function VolumeIcon({ size = 17, level = 1 }: IconProps & { level?: number }) {
  return (
    <Icon size={size}>
      <path d="M11 4 6 9H2v6h4l5 5z" />
      {level > 0.05 && <path d="M15.5 8.5a5 5 0 0 1 0 7" />}
      {level > 0.55 && <path d="M18.5 5.5a9 9 0 0 1 0 13" />}
    </Icon>
  );
}

export function VolumeOffIcon({ size = 17 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M11 4 6 9H2v6h4l5 5z" />
      <path d="m22 9-6 6" />
      <path d="m16 9 6 6" />
    </Icon>
  );
}

export function ScanIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M3 8V5a2 2 0 0 1 2-2h3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M3 12h18" />
    </Icon>
  );
}

export function QrIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <path d="M14 14h3v3h-3z" />
      <path d="M21 14v3" />
      <path d="M21 21h-4" />
    </Icon>
  );
}

export function ControlIcon({ size = 12 }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    </Icon>
  );
}
