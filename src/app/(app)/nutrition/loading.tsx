import { Skeleton } from "@/components/ui/skeleton";

export default function NutritionLoading() {
  return (
    <div
      className="mx-auto max-w-5xl px-4 py-8 lg:px-6 lg:py-10"
      role="status"
      aria-label="Loading nutrition tracker"
    >
      <div className="mb-7 space-y-2" aria-hidden="true">
        <Skeleton className="h-4 w-28 motion-reduce:animate-none" />
        <Skeleton className="h-8 w-36 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-full max-w-xl motion-reduce:animate-none" />
      </div>
      <div
        className="grid gap-7 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]"
        aria-hidden="true"
      >
        <div className="space-y-3">
          <Skeleton className="h-6 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-[32rem] w-full rounded-xl motion-reduce:animate-none" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-6 w-20 motion-reduce:animate-none" />
          <Skeleton className="h-80 w-full rounded-xl motion-reduce:animate-none" />
        </div>
        <div className="space-y-3 lg:col-span-2">
          <Skeleton className="h-6 w-28 motion-reduce:animate-none" />
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    </div>
  );
}
