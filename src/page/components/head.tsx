/**
 * Document head component emitting merged metadata, links, scripts, and children.
 *
 * @module
 */

import type { ReactNode } from 'react'

import { useOptionalPageContext } from '../context'

/** Props for the Head component. */
export interface HeadProps {
  /** Optional custom head elements provided by application components. */
  readonly children?: ReactNode
}

/** Emits document head tags derived from merged layout and page metadata. */
export function Head({ children }: HeadProps) {
  const meta = useOptionalPageContext()?.meta

  return (
    <>
      {meta?.title ? <title>{meta.title}</title> : null}
      {meta?.description ? <meta name="description" content={meta.description} /> : null}
      {meta?.canonical ? <link rel="canonical" href={meta.canonical} /> : null}
      {meta?.robots ? <meta name="robots" content={meta.robots} /> : null}

      {meta?.openGraph
        ? Object.entries(meta.openGraph).map(([property, content]) => (
            <meta
              key={`og:${property}`}
              property={property.includes(':') ? property : `og:${property}`}
              content={content}
            />
          ))
        : null}

      {meta?.twitter
        ? Object.entries(meta.twitter).map(([name, content]) => (
            <meta key={`twitter:${name}`} name={`twitter:${name}`} content={content} />
          ))
        : null}

      {meta?.links?.map((link, i) => {
        const {
          key: customKey,
          rel,
          href,
          type,
          media,
          as,
          crossOrigin,
          hreflang,
          imagesrcset,
          imagesizes,
          ...extra
        } = link
        const key = customKey ?? `${rel}:${href}:${i}`
        return (
          <link
            key={key}
            rel={rel}
            href={href}
            type={type}
            media={media}
            as={as}
            crossOrigin={crossOrigin}
            hrefLang={hreflang}
            imageSrcSet={imagesrcset}
            imageSizes={imagesizes}
            {...extra}
          />
        )
      })}

      {meta?.scripts?.map((script, i) => {
        const {
          content,
          key: customKey,
          src,
          type,
          async: isAsync,
          defer,
          crossOrigin,
          ...extra
        } = script
        const key = customKey ?? src ?? `script:${i}`
        return (
          <script
            key={key}
            src={src}
            type={type}
            async={isAsync}
            defer={defer}
            crossOrigin={crossOrigin}
            dangerouslySetInnerHTML={content ? { __html: content } : undefined}
            {...extra}
          />
        )
      })}

      {children}
    </>
  )
}
