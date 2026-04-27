import { create } from 'zustand'

export interface User {
  id: number
  email: string
  role: 'admin' | 'customer'
  is_active: boolean
}

interface AuthState {
  user: User | null
  token: string | null
  login: (token: string, user: User) => void
  logout: () => void
  isAdmin: () => boolean
  isAuthenticated: () => boolean
}

const stored = localStorage.getItem('user')
const storedToken = localStorage.getItem('access_token')

export const useAuthStore = create<AuthState>((set, get) => ({
  user: stored ? JSON.parse(stored) : null,
  token: storedToken,

  login: (token, user) => {
    localStorage.setItem('access_token', token)
    localStorage.setItem('user', JSON.stringify(user))
    set({ token, user })
  },

  logout: () => {
    localStorage.removeItem('access_token')
    localStorage.removeItem('user')
    set({ token: null, user: null })
  },

  isAdmin: () => get().user?.role === 'admin',
  isAuthenticated: () => !!get().token,
}))
