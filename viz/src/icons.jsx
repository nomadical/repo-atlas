// Only the icon definitions (SVG path data) are imported and rendered by a tiny inline-SVG
// component, without the FontAwesome runtime or CSS: a few KB, sized to 1em, colored by
// currentColor, and CSP-safe for the embed.
import {
  faGear,
  faCircleQuestion,
  faSun,
  faMoon,
  faLink,
  faTriangleExclamation,
  faXmark,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faMagnifyingGlass,
  faDownload,
  faArrowUpRightFromSquare,
  faRightLeft,
  faClock,
  faRocket,
  faBox,
  faBook,
  faPen,
  faCircle,
  faShareNodes,
  faEllipsis,
  faAngleRight,
  faCode,
  faListCheck,
} from '@fortawesome/free-solid-svg-icons'
import { faGithub } from '@fortawesome/free-brands-svg-icons'

const ICONS_BY_NAME = {
  gear: faGear,
  help: faCircleQuestion,
  sun: faSun,
  moon: faMoon,
  link: faLink,
  warning: faTriangleExclamation,
  close: faXmark,
  caretDown: faChevronDown,
  prev: faChevronLeft,
  next: faChevronRight,
  search: faMagnifyingGlass,
  download: faDownload,
  external: faArrowUpRightFromSquare,
  api: faRightLeft,
  clock: faClock,
  rocket: faRocket,
  box: faBox,
  book: faBook,
  edit: faPen,
  dot: faCircle,
  integrations: faShareNodes,
  more: faEllipsis,
  child: faAngleRight,
  code: faCode,
  // The Golden Path screen: a checklist, because the rocket already means auto-arrange.
  compliance: faListCheck,
  github: faGithub,
}

export function Icon({ name, className, title, ...rest }) {
  const definition = ICONS_BY_NAME[name]
  if (!definition) return null
  // IconDefinition.icon is [width, height, ligatures, unicode, svgPathData].
  const [width, height, , , pathData] = definition.icon
  const path = Array.isArray(pathData) ? pathData.join(' ') : pathData
  return (
    <svg
      className={'fa-svg' + (className ? ' ' + className : '')}
      viewBox={`0 0 ${width} ${height}`}
      width="1em"
      height="1em"
      fill="currentColor"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={path} />
    </svg>
  )
}
