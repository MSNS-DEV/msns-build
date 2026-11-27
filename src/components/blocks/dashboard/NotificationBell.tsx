"use client";

import { useEffect, useRef, useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  BellOff,
  CheckCheck,
  Megaphone,
  Sparkles,
  CalendarCheck,
  Info,
  Trash2,
  Check,
  CreditCard,
  ClipboardCheck,
  GraduationCap,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  getStoredNotifications,
  markAllNotificationsAsRead as markLocalAllRead,
  markNotificationAsRead as markLocalRead,
  clearAllNotifications as clearLocalAll,
  type StoredNotification,
} from "~/lib/mobile/notification-store";
import { api } from "~/trpc/react";
import { formatDistanceToNow } from "date-fns";
import { playNotificationChime } from "~/lib/audio-chime";

export type DisplayNotification = {
  id: string;
  title: string;
  body: string;
  category: string;
  actionUrl?: string | null;
  read: boolean;
  createdAt: string | Date;
  isServer: boolean;
};

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("ALL");
  const [localNotifications, setLocalNotifications] = useState<
    StoredNotification[]
  >([]);
  const [, startTransition] = useTransition();

  // tRPC query with auto-refresh every 30s
  const { data: serverNotifications, refetch: refetchNotifications } =
    api.notification.getAll.useQuery(undefined, {
      refetchInterval: 30000,
      staleTime: 10000,
    });

  const { data: serverUnreadCount, refetch: refetchUnread } =
    api.notification.getUnreadCount.useQuery(undefined, {
      refetchInterval: 30000,
      staleTime: 10000,
    });

  const markAsReadMutation = api.notification.markAsRead.useMutation({
    onSuccess: () => {
      void refetchNotifications();
      void refetchUnread();
    },
  });

  const markAllAsReadMutation = api.notification.markAllAsRead.useMutation({
    onSuccess: () => {
      void refetchNotifications();
      void refetchUnread();
    },
  });

  const deleteMutation = api.notification.delete.useMutation({
    onSuccess: () => {
      void refetchNotifications();
      void refetchUnread();
    },
  });

  const clearAllMutation = api.notification.clearAll.useMutation({
    onSuccess: () => {
      void refetchNotifications();
      void refetchUnread();
    },
  });

  // Sync offline/local store notifications
  const reloadLocalNotifications = () => {
    setLocalNotifications(getStoredNotifications());
  };

  useEffect(() => {
    reloadLocalNotifications();
    const handleUpdate = () => {
      reloadLocalNotifications();
      void refetchNotifications();
      void refetchUnread();
    };
    window.addEventListener("msns_notifications_updated", handleUpdate);
    return () => {
      window.removeEventListener("msns_notifications_updated", handleUpdate);
    };
  }, [refetchNotifications, refetchUnread]);

  // Combine server and local notifications seamlessly (de-duplicating by title + body)
  const combinedNotifications = useMemo<DisplayNotification[]>(() => {
    const list: DisplayNotification[] = [];
    const seen = new Set<string>();

    if (serverNotifications) {
      for (const sn of serverNotifications) {
        const key = `${sn.title}_${sn.body}`;
        seen.add(key);
        list.push({
          id: sn.id,
          title: sn.title,
          body: sn.body,
          category: sn.category,
          actionUrl: sn.actionUrl,
          read: sn.read,
          createdAt: sn.createdAt,
          isServer: true,
        });
      }
    }

    for (const ln of localNotifications) {
      const key = `${ln.title}_${ln.body}`;
      if (!seen.has(key)) {
        list.push({
          id: ln.id,
          title: ln.title,
          body: ln.body,
          category: ln.category,
          actionUrl: ln.actionUrl,
          read: ln.read,
          createdAt: ln.timestamp,
          isServer: false,
        });
      }
    }

    return list.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [serverNotifications, localNotifications]);

  const totalUnreadCount = useMemo(() => {
    const localUnread = localNotifications.filter((n) => !n.read).length;
    return (serverUnreadCount ?? 0) + localUnread;
  }, [serverUnreadCount, localNotifications]);

  // Audio chime trigger on incoming unread count increase
  const prevUnreadRef = useRef<number>(totalUnreadCount);
  useEffect(() => {
    if (totalUnreadCount > prevUnreadRef.current) {
      playNotificationChime();
    }
    prevUnreadRef.current = totalUnreadCount;
  }, [totalUnreadCount]);

  const filteredNotifications = useMemo(() => {
    if (activeTab === "ALL") return combinedNotifications;
    return combinedNotifications.filter((n) => n.category === activeTab);
  }, [combinedNotifications, activeTab]);

  const handleMarkAllRead = () => {
    markLocalAllRead();
    reloadLocalNotifications();
    markAllAsReadMutation.mutate();
  };

  const handleClearAll = () => {
    clearLocalAll();
    reloadLocalNotifications();
    clearAllMutation.mutate();
  };

  const handleItemClick = (notif: DisplayNotification) => {
    if (!notif.read) {
      if (notif.isServer) {
        markAsReadMutation.mutate({ id: notif.id });
      } else {
        markLocalRead(notif.id);
        reloadLocalNotifications();
      }
    }
    if (notif.actionUrl) {
      setOpen(false);
      startTransition(() => {
        router.push(notif.actionUrl!);
      });
    }
  };

  const handleDeleteItem = (
    e: React.MouseEvent,
    notif: DisplayNotification,
  ) => {
    e.stopPropagation();
    if (notif.isServer) {
      deleteMutation.mutate({ id: notif.id });
    } else {
      markLocalRead(notif.id);
      reloadLocalNotifications();
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "BROADCAST":
        return <Megaphone className="h-4 w-4 text-amber-500" />;
      case "FEE":
        return <CreditCard className="h-4 w-4 text-emerald-500" />;
      case "ATTENDANCE":
        return <ClipboardCheck className="h-4 w-4 text-rose-500" />;
      case "EXAM":
        return <GraduationCap className="h-4 w-4 text-indigo-500" />;
      case "FEATURE_EXPLORE":
        return <Sparkles className="h-4 w-4 text-blue-500" />;
      case "DAILY_TASK":
        return <CalendarCheck className="h-4 w-4 text-purple-500" />;
      default:
        return <Info className="h-4 w-4 text-emerald-500" />;
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="group relative rounded-full transition-colors hover:bg-emerald-50 dark:hover:bg-slate-800"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5 text-slate-600 transition-colors group-hover:text-emerald-600 dark:text-emerald-100 dark:group-hover:text-emerald-400" />
          {totalUnreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white shadow-md ring-2 ring-white duration-200 animate-in fade-in zoom-in dark:ring-slate-900">
              {totalUnreadCount > 9 ? "9+" : totalUnreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="z-50 w-[360px] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-2xl dark:border-border dark:bg-slate-900 sm:w-[440px]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 p-4 backdrop-blur-md dark:border-border/60 dark:bg-slate-900/70">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              Notifications & Alerts
            </h3>
            {totalUnreadCount > 0 && (
              <Badge className="border-none bg-emerald-100 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                {totalUnreadCount} new
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1">
            {totalUnreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleMarkAllRead}
                className="h-8 px-2 text-xs text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                title="Mark all as read"
              >
                <CheckCheck className="mr-1 h-3.5 w-3.5" />
                Mark all
              </Button>
            )}
            {combinedNotifications.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleClearAll}
                className="h-8 w-8 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"
                title="Clear all notifications"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Category Tabs */}
        <div className="border-b border-slate-100 bg-white px-3 pb-2 pt-2.5 dark:border-border/40 dark:bg-slate-900">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="w-full"
          >
            <TabsList className="scrollbar-none flex h-8 w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-0.5 text-[11px] dark:bg-slate-800">
              <TabsTrigger
                value="ALL"
                className="min-w-fit flex-1 px-2 py-1 text-[11px]"
              >
                All ({combinedNotifications.length})
              </TabsTrigger>
              <TabsTrigger
                value="BROADCAST"
                className="min-w-fit flex-1 px-2 py-1 text-[11px]"
              >
                📢 Alerts
              </TabsTrigger>
              <TabsTrigger
                value="FEE"
                className="min-w-fit flex-1 px-2 py-1 text-[11px]"
              >
                💳 Fee
              </TabsTrigger>
              <TabsTrigger
                value="ATTENDANCE"
                className="min-w-fit flex-1 px-2 py-1 text-[11px]"
              >
                📋 Attendance
              </TabsTrigger>
              <TabsTrigger
                value="EXAM"
                className="min-w-fit flex-1 px-2 py-1 text-[11px]"
              >
                🎓 Exams
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Notification List */}
        <div className="max-h-[380px] divide-y divide-slate-100 overflow-y-auto dark:divide-border/40">
          {filteredNotifications.length > 0 ? (
            filteredNotifications.map((notif) => (
              <div
                key={notif.id}
                onClick={() => handleItemClick(notif)}
                className={`group relative flex cursor-pointer gap-3 p-3.5 transition-all duration-150 ${
                  notif.read
                    ? "bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/60"
                    : "bg-emerald-50/40 hover:bg-emerald-50/70 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/40"
                }`}
              >
                <div className="mt-0.5 h-fit flex-shrink-0 rounded-full border border-slate-200 bg-slate-100 p-2 dark:border-border dark:bg-slate-800">
                  {getCategoryIcon(notif.category)}
                </div>

                <div className="min-w-0 flex-1 pr-2">
                  <div className="flex items-center justify-between gap-1">
                    <h4
                      className={`truncate text-xs ${
                        notif.read
                          ? "font-medium text-slate-700 dark:text-slate-300"
                          : "font-bold text-slate-900 dark:text-slate-100"
                      }`}
                    >
                      {notif.title}
                    </h4>
                    {!notif.read && (
                      <span className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500" />
                    )}
                  </div>

                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                    {notif.body}
                  </p>

                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                      {formatTimeAgo(notif.createdAt)}
                    </span>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {!notif.read && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (notif.isServer) {
                              markAsReadMutation.mutate({ id: notif.id });
                            } else {
                              markLocalRead(notif.id);
                              reloadLocalNotifications();
                            }
                          }}
                          className="h-5 px-1.5 text-[10px] text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400"
                        >
                          <Check className="mr-1 h-3 w-3" />
                          Read
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => handleDeleteItem(e, notif)}
                        className="h-5 px-1.5 text-[10px] text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center p-10 text-center text-slate-500">
              <BellOff className="mb-3 h-10 w-10 stroke-1 text-slate-300 dark:text-slate-700" />
              <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                No notifications in this category
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                You are all caught up!
              </p>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatTimeAgo(dateInput: string | Date): string {
  try {
    const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return "Recently";
  }
}
