"use client";

import { useState } from "react";
import {
  ArrowRight,
  MessageSquare,
  Pin,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { api } from "~/trpc/react";
import { format } from "date-fns";
import Link from "next/link";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

export function BroadcastBoard() {
  const [isOpen, setIsOpen] = useState(false);
  // Use real Events from DB — filter to upcoming/SCHEDULED events as "broadcasts"
  const { data, isLoading } = api.event.getAll.useQuery({ limit: 5 });
  const announcements = data?.events ?? [];

  return (
    <Card className="card-enhanced flex h-full flex-col">
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className="flex w-full flex-1 flex-col"
      >
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-orange-500/10 p-2 text-orange-400">
              <MessageSquare className="h-5 w-5" />
            </div>
            <CardTitle>Broadcasts</CardTitle>
          </div>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-all duration-200",
                  isOpen ? "rotate-180" : "",
                )}
              />
              <span className="sr-only">Toggle</span>
            </Button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent className="flex-1">
          <CardContent className="flex h-full flex-col space-y-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : announcements.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No announcements yet.
              </div>
            ) : (
              announcements.map((event) => {
                const isUrgent =
                  event.priority === "URGENT" || event.priority === "HIGH";
                return (
                  <div
                    key={event.id}
                    className="group relative flex flex-col gap-2 rounded-xl border border-border bg-black/5 p-4 transition-all hover:bg-black/10 dark:bg-black/20 dark:hover:bg-black/40"
                  >
                    {isUrgent && (
                      <Pin className="absolute right-4 top-4 h-4 w-4 text-red-500 opacity-50 transition-opacity group-hover:opacity-100" />
                    )}
                    <div>
                      <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        {event.title}
                        {isUrgent && (
                          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] uppercase text-red-500">
                            Urgent
                          </span>
                        )}
                      </h4>
                      {event.description && (
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {event.description}
                        </p>
                      )}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                      <span className="capitalize">
                        {event.type?.toLowerCase().replace("_", " ")}
                      </span>
                      <span>
                        {format(new Date(event.startDateTime), "MMM d, yyyy")}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
            <div className="mt-auto pt-2">
              <Link href="/admin/events">
                <Button
                  variant="ghost"
                  className="w-full text-xs text-muted-foreground hover:text-foreground"
                >
                  View All Events <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
