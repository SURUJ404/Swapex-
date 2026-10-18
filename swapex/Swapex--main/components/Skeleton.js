import React from 'react'

/** Token-colored pulse placeholder. Decorative; pair with role="status" + aria-label at call sites. */
export default function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-[var(--border)] ${className}`} />
}
