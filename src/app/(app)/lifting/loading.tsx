import { Skeleton } from "@/components/ui/skeleton";

export default function LiftingLoading() {
  return (
    <div
      className="mx-auto max-w-3xl px-4 py-8 lg:px-6 lg:py-10"
      role="status"
      aria-label="Loading manual lifting"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4" aria-hidden="true">
        <div className="space-y-2">
          <Skeleton className="h-8 w-44 motion-reduce:animate-none" />
          <Skeleton className="h-4 w-72 max-w-full motion-reduce:animate-none" />
        </div>
        <Skeleton className="h-11 w-28 motion-reduce:animate-none" />
      </div>
      <div className="space-y-3" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-28 w-full rounded-xl motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}
