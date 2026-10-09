import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";

// Kept in its own module so the picker and its emoji dataset are only
// downloaded when it's opened.
export default function EmojiPicker({
  onEmojiSelect,
}: {
  onEmojiSelect: (emoji: { native: string }) => void;
}) {
  return <Picker data={data} onEmojiSelect={onEmojiSelect} />;
}
