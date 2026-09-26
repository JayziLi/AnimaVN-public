import type { SVGProps } from 'react'

export type AnimaIconName =
  | 'preset'
  | 'character-card'
  | 'player'
  | 'more'
  | 'import'
  | 'export'
  | 'add'
  | 'edit'
  | 'copy'
  | 'save'
  | 'restore'
  | 'delete'
  | 'list'
  | 'sliders'
  | 'branch'
  | 'history'
  | 'new-chat'
  | 'refresh'
  | 'jump-latest'
  | 'panel-left'
  | 'panel-right'
  | 'vn'
  | 'plugin'

type AnimaIconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  name: AnimaIconName
  size?: number
  title?: string
}

export function AnimaIcon({
  name,
  size = 18,
  title,
  style,
  ...props
}: AnimaIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      style={{ display: 'block', flex: '0 0 auto', ...style }}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <use href={`/assets/anima-ui-icons.svg#${name}`} />
    </svg>
  )
}
