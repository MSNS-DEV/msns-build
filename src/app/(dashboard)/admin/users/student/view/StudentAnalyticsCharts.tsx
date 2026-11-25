"use client";

import { BarChart3, PieChartIcon } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

const COLORS = [
  "#059669",
  "#0284c7",
  "#7c3aed",
  "#ea580c",
  "#db2777",
  "#eab308",
];

export function StudentAnalyticsCharts({
  isLoading,
  genderData,
  registrationTrends,
}: {
  isLoading: boolean;
  genderData: { name: string; value: number }[];
  registrationTrends: { name: string; count: number }[];
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card className="border border-slate-200 bg-white shadow-sm dark:border-emerald-500/10 dark:bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <PieChartIcon className="h-4 w-4 text-emerald-600" /> Gender
            Distribution
          </CardTitle>
        </CardHeader>
        <CardContent className="flex h-64 items-center justify-center">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">
              Loading chart data...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={genderData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) =>
                    `${name} (${(percent * 100).toFixed(0)}%)`
                  }
                >
                  {genderData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={COLORS[index % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => [`${value as number} students`]}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white shadow-sm dark:border-emerald-500/10 dark:bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <BarChart3 className="h-4 w-4 text-emerald-600" /> Recent
            Registration Trends
          </CardTitle>
        </CardHeader>
        <CardContent className="h-64">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading chart data...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={registrationTrends}>
                <XAxis
                  dataKey="name"
                  fontSize={11}
                  stroke="currentColor"
                  className="text-muted-foreground"
                />
                <YAxis
                  fontSize={11}
                  stroke="currentColor"
                  className="text-muted-foreground"
                />
                <Tooltip
                  formatter={(value) => [`${value as number} registrations`]}
                />
                <Bar dataKey="count" fill="#0284c7" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
