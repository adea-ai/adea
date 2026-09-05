import { useEffect, useState } from "react";
import { BotMessageSquare, CircleUserRound } from "lucide-react";

export function ConversationAvatar({
  avatarRef,
  kind,
}: Readonly<{
  avatarRef?: string;
  kind: "agent" | "system" | "user";
}>) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarRef]);

  if (avatarRef && !imageFailed)
    return <img src={avatarRef} alt="" onError={() => setImageFailed(true)} />;

  return kind === "user" ? (
    <CircleUserRound aria-hidden="true" />
  ) : (
    <BotMessageSquare aria-hidden="true" />
  );
}
