import { describe, expect, it } from 'vitest'

import { discoverPages } from '../../src/tooling/build/discover/pages'
import { createProject } from '../helpers/project'

describe('discoverPages', () => {
  it('shares escaped dots, index normalization and route groups with API paths', () => {
    const project = createProject()
    try {
      project.write('app/(content)/files/file[.]name/index.tsx', 'export default () => null')
      project.write('app/(content)/files/[...parts]/index.tsx', 'export default () => null')
      const tree = discoverPages(project.root + '/app', '/site')
      expect(tree.pages.map((page) => page.routePath.urlPath)).toEqual([
        '/site/files/file.name',
        '/site/files/*',
      ])
      expect(tree.pages[1].routePath.wildcardName).toBe('parts')
      project.write('app/(other)/FILES/file[.]name.tsx', 'export default () => null')
      expect(() => discoverPages(project.root + '/app', '/site')).toThrow('Page conflict')
    } finally {
      project.remove()
    }
  })

  it('returns empty structures when page directory is disabled or missing', () => {
    expect(discoverPages(false, '/')).toEqual({
      pages: [],
      layouts: new Map(),
      errors: new Map(),
      middlewares: new Map(),
    })

    expect(discoverPages('non_existent_dir_12345', '/')).toEqual({
      pages: [],
      layouts: new Map(),
      errors: new Map(),
      middlewares: new Map(),
    })
  })

  it('discovers root document, layouts, errors, middlewares, and pages', () => {
    const project = createProject()
    try {
      project.write('app/_root.tsx', 'export default function Root() { return null }')
      project.write('app/_layout.tsx', 'export default function RootLayout() { return null }')
      project.write('app/_error.tsx', 'export default function RootError() { return null }')
      project.write('app/_middleware.ts', 'export default function RootMiddleware() {}')
      project.write('app/index.tsx', 'export default function Home() { return null }')
      project.write(
        'app/posts/_layout.tsx',
        'export default function PostsLayout() { return null }',
      )
      project.write('app/posts/_error.tsx', 'export default function PostsError() { return null }')
      project.write(
        'app/posts/[id].tsx',
        `export default function PostDetail() { return null }
         export async function loader() { return { id: '1' } }
         export async function action() { return {} }
         export function meta() { return { title: 'Post' } }
         export const cache = { ttl: 60 }
         export const shouldRevalidate = () => false`,
      )
      project.write('app/posts/[...slug].tsx', 'export default function CatchAll() { return null }')
      project.write('app/(marketing)/about.tsx', 'export default function About() { return null }')
      project.write('app/users.profile.tsx', 'export default function Profile() { return null }')

      // Files that should be ignored
      project.write('app/useHelper.ts', 'export function useHelper() {}')
      project.write('app/_components/Button.tsx', 'export function Button() { return null }')
      project.write('app/_helper.tsx', 'export function Helper() { return null }')
      project.write('app/index.test.tsx', 'export default function Test() {}')
      project.write('app/types.d.ts', 'export type Foo = string')

      const tree = discoverPages(project.root + '/app', '/')

      // Root document
      expect(tree.rootDocument).toBeDefined()
      expect(tree.rootDocument?.relativePath).toBe('_root.tsx')
      expect(tree.rootDocument?.exports.hasDefault).toBe(true)

      // Layouts
      expect(tree.layouts.size).toBe(2)
      expect(tree.layouts.get('')?.relativePath).toBe('_layout.tsx')
      expect(tree.layouts.get('posts')?.relativePath).toBe('posts/_layout.tsx')

      // Errors
      expect(tree.errors.size).toBe(2)
      expect(tree.errors.get('')?.relativePath).toBe('_error.tsx')
      expect(tree.errors.get('posts')?.relativePath).toBe('posts/_error.tsx')

      // Middlewares
      expect(tree.middlewares.size).toBe(1)
      expect(tree.middlewares.get('')?.relativePath).toBe('_middleware.ts')

      // Discovered pages & route precedence: Static > Param > Wildcard
      const paths = tree.pages.map((p) => p.routePath.urlPath)
      expect(paths).toEqual(['/', '/about', '/users/profile', '/posts/:id', '/posts/*'])

      // Page inspection for posts/[id]
      const postPage = tree.pages.find((p) => p.routePath.urlPath === '/posts/:id')
      expect(postPage).toBeDefined()
      expect(postPage?.routePath.paramNames).toEqual(['id'])
      expect(postPage?.routePath.shapeKey).toBe('/posts/:param')
      expect(postPage?.exports.hasDefault).toBe(true)
      expect(postPage?.exports.hasLoader).toBe(true)
      expect(postPage?.exports.hasAction).toBe(true)
      expect(postPage?.exports.hasMeta).toBe(true)
      expect(postPage?.exports.hasCache).toBe(true)
      expect(postPage?.exports.hasShouldRevalidate).toBe(true)

      // Scope hierarchy & chains for posts/[id]
      expect(postPage?.layoutChain.map((l) => l.relativePath)).toEqual([
        '_layout.tsx',
        'posts/_layout.tsx',
      ])
      expect(postPage?.closestError?.relativePath).toBe('posts/_error.tsx')
      expect(postPage?.middlewareChain.map((m) => m.relativePath)).toEqual(['_middleware.ts'])

      // Page inspection for about (in route group)
      const aboutPage = tree.pages.find((p) => p.routePath.urlPath === '/about')
      expect(aboutPage).toBeDefined()
      expect(aboutPage?.closestError?.relativePath).toBe('_error.tsx')
      expect(aboutPage?.layoutChain.map((l) => l.relativePath)).toEqual(['_layout.tsx'])

      // Page inspection for catchall
      const catchallPage = tree.pages.find((p) => p.routePath.urlPath === '/posts/*')
      expect(catchallPage).toBeDefined()
      expect(catchallPage?.routePath.wildcardName).toBe('slug')
    } finally {
      project.remove()
    }
  })

  it('supports flat dot syntax for layouts, errors, and middlewares', () => {
    const project = createProject()
    try {
      project.write(
        'app/admin.users._layout.tsx',
        'export default function Layout() { return null }',
      )
      project.write('app/admin.users._error.tsx', 'export default function Error() { return null }')
      project.write('app/admin.users._middleware.ts', 'export default function Middleware() {}')
      project.write('app/admin/users/index.tsx', 'export default function Users() { return null }')

      const tree = discoverPages(project.root + '/app', '/')
      expect(tree.layouts.get('admin/users')?.relativePath).toBe('admin.users._layout.tsx')
      expect(tree.errors.get('admin/users')?.relativePath).toBe('admin.users._error.tsx')
      expect(tree.middlewares.get('admin/users')?.relativePath).toBe('admin.users._middleware.ts')

      const userPage = tree.pages[0]
      expect(userPage.routePath.urlPath).toBe('/admin/users')
      expect(userPage.layoutChain.map((l) => l.relativePath)).toEqual(['admin.users._layout.tsx'])
      expect(userPage.closestError?.relativePath).toBe('admin.users._error.tsx')
      expect(userPage.middlewareChain.map((m) => m.relativePath)).toEqual([
        'admin.users._middleware.ts',
      ])
    } finally {
      project.remove()
    }
  })

  it('rejects duplicate pages with conflicting path shapes', () => {
    const project = createProject()
    try {
      project.write('app/posts/[id].tsx', 'export default function Post() { return null }')
      project.write('app/posts/[slug].tsx', 'export default function PostSlug() { return null }')

      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Page conflict detected: duplicate page for "\/posts\/:param"/,
      )
    } finally {
      project.remove()
    }
  })

  it('rejects duplicate layouts in the same logical scope', () => {
    const project = createProject()
    try {
      project.write('app/posts/_layout.tsx', 'export default function Layout1() { return null }')
      project.write('app/posts._layout.tsx', 'export default function Layout2() { return null }')

      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Layout conflict detected: duplicate layout for scope "posts"/,
      )
    } finally {
      project.remove()
    }
  })

  it('rejects duplicate errors in the same logical scope', () => {
    const project = createProject()
    try {
      project.write('app/posts/_error.tsx', 'export default function Error1() { return null }')
      project.write('app/posts._error.tsx', 'export default function Error2() { return null }')

      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Error boundary conflict detected: duplicate error boundary for scope "posts"/,
      )
    } finally {
      project.remove()
    }
  })

  it('rejects duplicate middlewares in the same logical scope', () => {
    const project = createProject()
    try {
      project.write('app/posts/_middleware.ts', 'export default function Mw1() {}')
      project.write('app/posts._middleware.ts', 'export default function Mw2() {}')

      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Page middleware conflict detected: duplicate middleware for scope "posts"/,
      )
    } finally {
      project.remove()
    }
  })

  it('rejects non-terminal wildcards', () => {
    const project = createProject()
    try {
      project.write(
        'app/posts/[...slug]/edit.tsx',
        'export default function Edit() { return null }',
      )

      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Wildcard must be the terminal URL segment/,
      )
    } finally {
      project.remove()
    }
  })

  it('rejects action exports from layout modules', () => {
    const project = createProject()
    try {
      project.write(
        'app/_layout.tsx',
        `export default function Layout() { return null }
         export async function action() {}`,
      )

      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Layout module "_layout\.tsx" cannot export "action"/,
      )
    } finally {
      project.remove()
    }
  })

  it('rejects data hook exports from root document', () => {
    const project = createProject()
    try {
      project.write(
        'app/_root.tsx',
        `export default function Root() { return null }
         export async function loader() {}`,
      )

      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Root document "_root\.tsx" cannot export data hooks/,
      )
    } finally {
      project.remove()
    }
  })

  it('rejects page modules missing a default export', () => {
    const project = createProject()
    try {
      project.write('app/index.tsx', 'export const loader = async () => ({})')

      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Page module "index\.tsx" must export a default React component/,
      )
    } finally {
      project.remove()
    }
  })

  it('reports syntax errors instead of inventing page exports', () => {
    const project = createProject()
    try {
      project.write('app/index.tsx', 'export const loader =')
      expect(() => discoverPages(project.root + '/app', '/')).toThrowError(
        /Failed to parse .*index\.tsx/,
      )
    } finally {
      project.remove()
    }
  })
})
