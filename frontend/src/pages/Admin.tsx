import Layout from '../components/Layout'
import AdminPanel from '../components/AdminPanel'

export default function Admin() {
  return (
    <Layout>
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-foreground">Admin Panel</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Manage models, users, and application settings
          </p>
        </div>
        <AdminPanel />
      </div>
    </Layout>
  )
}
