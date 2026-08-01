export interface CaptionState {
  cueCount: number;
  hasCaptions: boolean;
  isVisible: boolean;
}

export type ContentRequest =
  | { type: "GET_CAPTION_STATE" }
  | { type: "GET_CAPTION_CONTENT" }
  | { type: "TOGGLE_CAPTION_VISIBILITY" }
  | {
      type: "SET_CAPTIONS";
      sourceUrl: string;
      srt: string;
    }
  | { type: "TOGGLE_INLINE_PANEL" }
  | { type: "CLOSE_INLINE_PANEL" };

export type ContentResponse =
  | ({ ok: true } & CaptionState & {
      sourceUrl?: string;
      srt?: string;
    })
  | { ok: false; error: string };
