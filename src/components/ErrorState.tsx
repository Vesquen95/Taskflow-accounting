interface ErrorStateProps {
  message: string
  onRetry: () => void
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-lg border border-red-200 bg-red-50 p-8 text-center"
    >
      <p className="text-sm font-medium text-red-700">Er ging iets mis</p>
      <p className="max-w-sm text-sm text-red-600">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
      >
        Opnieuw proberen
      </button>
    </div>
  )
}
