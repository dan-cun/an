const standaloneCockpit = window.location.pathname.startsWith('/cockpit') || window.location.pathname === '/dashboard'

if (standaloneCockpit) {
  import('./cockpit-entry.jsx')
} else {
  import('./main.jsx')
}
