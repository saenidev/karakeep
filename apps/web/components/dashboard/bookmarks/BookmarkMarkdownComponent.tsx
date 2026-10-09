import dynamic from "next/dynamic";
import { toast } from "@/components/ui/sonner";

import { useUpdateBookmark } from "@karakeep/shared-react/hooks/bookmarks";

// Loaded on demand so the markdown renderer stays out of the main bundle.
const MarkdownReadonly = dynamic(() =>
  import("@/components/ui/markdown/markdown-readonly").then(
    (m) => m.MarkdownReadonly,
  ),
);

// The editor (Lexical) is only needed once the user starts editing a note.
const MarkdownEditor = dynamic(
  () => import("@/components/ui/markdown/markdown-editor"),
);

export function BookmarkMarkdownComponent({
  children: bookmark,
  readOnly = true,
}: {
  children: {
    id: string;
    content: {
      text: string;
    };
  };
  readOnly?: boolean;
}) {
  const { mutate: updateBookmarkMutator, isPending } = useUpdateBookmark({
    onSuccess: () => {
      toast({
        description: "Note updated!",
      });
    },
    onError: () => {
      toast({ description: "Something went wrong", variant: "destructive" });
    },
  });

  const onSave = (text: string) => {
    updateBookmarkMutator({
      bookmarkId: bookmark.id,
      text,
    });
  };

  return (
    <div className="h-full">
      {readOnly ? (
        <MarkdownReadonly onSave={onSave}>
          {bookmark.content.text}
        </MarkdownReadonly>
      ) : (
        <MarkdownEditor onSave={onSave} isSaving={isPending}>
          {bookmark.content.text}
        </MarkdownEditor>
      )}
    </div>
  );
}
