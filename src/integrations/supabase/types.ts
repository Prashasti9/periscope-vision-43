export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      founders: {
        Row: {
          accelerator: string | null
          axes: Json
          claims: Json
          company: string
          created_at: string
          founder_score: Json
          gaps: Json
          geo: string
          id: string
          momentum: Json
          name: string
          one_liner: string
          prior_vc: boolean
          sector: string
          signals: Json
          sort_order: number
          stage: string
          tags: Json
          track: string
        }
        Insert: {
          accelerator?: string | null
          axes: Json
          claims?: Json
          company: string
          created_at?: string
          founder_score: Json
          gaps?: Json
          geo: string
          id: string
          momentum?: Json
          name: string
          one_liner: string
          prior_vc?: boolean
          sector: string
          signals?: Json
          sort_order?: number
          stage: string
          tags?: Json
          track: string
        }
        Update: {
          accelerator?: string | null
          axes?: Json
          claims?: Json
          company?: string
          created_at?: string
          founder_score?: Json
          gaps?: Json
          geo?: string
          id?: string
          momentum?: Json
          name?: string
          one_liner?: string
          prior_vc?: boolean
          sector?: string
          signals?: Json
          sort_order?: number
          stage?: string
          tags?: Json
          track?: string
        }
        Relationships: []
      }
      people_candidates: {
        Row: {
          activated_at: string | null
          axes: Json | null
          companies: string
          founder_score: Json | null
          identity_key: string
          momentum: Json
          outreach_draft: string | null
          person_or_handle: string
          scored_at: string | null
          signal_count: number
          source_count: number
          sources: string
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          axes?: Json | null
          companies?: string
          founder_score?: Json | null
          identity_key: string
          momentum?: Json
          outreach_draft?: string | null
          person_or_handle: string
          scored_at?: string | null
          signal_count?: number
          source_count?: number
          sources?: string
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          axes?: Json | null
          companies?: string
          founder_score?: Json | null
          identity_key?: string
          momentum?: Json
          outreach_draft?: string | null
          person_or_handle?: string
          scored_at?: string | null
          signal_count?: number
          source_count?: number
          sources?: string
          updated_at?: string
        }
        Relationships: []
      }
      real_signals: {
        Row: {
          content: string
          created_at: string
          date: string
          id: string
          query: string
          reliability: number
          score: number
          source: string
          subject: string
          title: string
          url: string
        }
        Insert: {
          content?: string
          created_at?: string
          date?: string
          id?: string
          query?: string
          reliability?: number
          score?: number
          source?: string
          subject?: string
          title?: string
          url?: string
        }
        Update: {
          content?: string
          created_at?: string
          date?: string
          id?: string
          query?: string
          reliability?: number
          score?: number
          source?: string
          subject?: string
          title?: string
          url?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          company: string
          date: string
          ingested_at: string
          person_or_handle: string
          reliability: number
          signal_id: string
          source: string
          text: string
          url: string
        }
        Insert: {
          company?: string
          date?: string
          ingested_at?: string
          person_or_handle?: string
          reliability?: number
          signal_id: string
          source: string
          text?: string
          url?: string
        }
        Update: {
          company?: string
          date?: string
          ingested_at?: string
          person_or_handle?: string
          reliability?: number
          signal_id?: string
          source?: string
          text?: string
          url?: string
        }
        Relationships: []
      }
      thesis_config: {
        Row: {
          check_size: number
          cities: Json
          geographies: Json
          id: string
          ownership_target: number
          risk: string
          sectors: Json
          stages: Json
          updated_at: string
        }
        Insert: {
          check_size?: number
          cities?: Json
          geographies?: Json
          id?: string
          ownership_target?: number
          risk?: string
          sectors?: Json
          stages?: Json
          updated_at?: string
        }
        Update: {
          check_size?: number
          cities?: Json
          geographies?: Json
          id?: string
          ownership_target?: number
          risk?: string
          sectors?: Json
          stages?: Json
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
