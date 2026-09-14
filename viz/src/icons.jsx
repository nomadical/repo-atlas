// Central FontAwesome icon set. We import only the icon *definitions* (SVG path data) from the
// free packages and render them with a tiny inline-SVG component — no @fortawesome/react-fontawesome
// or fontawesome-svg-core runtime/CSS. That keeps just the ~24 used icons (a few KB of path data),
// scales to the font size (1em), inherits color (currentColor), and is CSP-safe for the embed.
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

const MAP = {
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
  compliance: faListCheck, // the Golden Path screen — a checklist, not the rocket (auto-arrange)
  github: faGithub,
}

// IconDefinition.icon = [width, height, ligatures, unicode, svgPathData]
export function Icon({ name, className, title, ...rest }) {
  const def = MAP[name]
  if (!def) return null
  const [w, h, , , path] = def.icon
  const d = Array.isArray(path) ? path.join(' ') : path
  return (
    <svg
      className={'fa-svg' + (className ? ' ' + className : '')}
      viewBox={`0 0 ${w} ${h}`}
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
      <path d={d} />
    </svg>
  )
}
