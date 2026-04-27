import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Shield, Settings, LogOut, ChevronDown, User, Sun, Moon,
} from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useTheme } from '../../lib/theme'
import ConfigModal from '../ConfigModal'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout, isAdmin } = useAuthStore()
  const { theme, toggleTheme } = useTheme()
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const navLinks = [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    ...(isAdmin() ? [{ to: '/admin', label: 'Admin', icon: Shield }] : []),
  ]

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="bg-card border-b border-border sticky top-0 z-40 shadow-sm dark:shadow-none">
        <div className="max-w-screen-xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">

          {/* Logo */}
          <Link to="/dashboard" className="flex items-center flex-shrink-0 group">
            <img
              src="/aeologo.png"
              alt="Aeologic"
              className="h-8 object-contain dark:bg-white dark:rounded-md dark:px-2 dark:py-0.5 transition-all"
            />
          </Link>

          {/* Nav */}
          <nav className="flex items-center gap-0.5">
            {navLinks.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  location.pathname === to
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden sm:block">{label}</span>
              </Link>
            ))}
          </nav>

          {/* Right actions */}
          <div className="flex items-center gap-1">
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
              title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            >
              {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>

            {/* Config */}
            <button
              onClick={() => setShowConfigModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
              title="Configure API Keys"
            >
              <Settings className="w-3.5 h-3.5" />
              <span className="hidden sm:block text-sm font-medium">Config</span>
            </button>

            {/* User menu */}
            <div className="relative">
              <button
                onClick={() => setShowUserMenu((v) => !v)}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-muted transition-all"
              >
                <div className="w-6 h-6 bg-primary/10 rounded-full flex items-center justify-center border border-primary/20">
                  <User className="w-3.5 h-3.5 text-primary" />
                </div>
                <span className="text-sm text-foreground font-medium hidden sm:block max-w-[110px] truncate">
                  {user?.email?.split('@')[0]}
                </span>
                <ChevronDown className="w-3 h-3 text-muted-foreground hidden sm:block" />
              </button>

              {showUserMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowUserMenu(false)} />
                  <div className="absolute right-0 top-full mt-1.5 w-56 bg-card border border-border rounded-xl shadow-lg z-20 py-1 animate-fade-in">
                    <div className="px-3 py-2.5 border-b border-border">
                      <p className="text-sm font-medium text-foreground truncate">{user?.email}</p>
                      <span className={user?.role === 'admin' ? 'badge-admin mt-1' : 'badge-customer mt-1'}>
                        {user?.role}
                      </span>
                    </div>
                    <button
                      onClick={() => { setShowConfigModal(true); setShowUserMenu(false) }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      API Keys & Config
                    </button>
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-destructive hover:bg-destructive/5 transition-colors"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1">{children}</main>

      {showConfigModal && <ConfigModal onClose={() => setShowConfigModal(false)} />}
    </div>
  )
}
