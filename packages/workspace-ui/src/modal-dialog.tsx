import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@adea/ui/components/ui/dialog";
import { cn } from "@adea/ui/lib/utils";

export function ModalDialog({
  children,
  className,
  description,
  headerLeading,
  onClose,
  open,
  title,
}: Readonly<{
  children: ReactNode;
  className?: string;
  description?: string;
  headerLeading?: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}>) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className={cn("conventional-dialog", className)}>
        <DialogHeader className="conventional-dialog__header">
          {headerLeading ? (
            <div className="conventional-dialog__heading">
              {headerLeading}
              <div>
                <DialogTitle>{title}</DialogTitle>
                {description ? <DialogDescription>{description}</DialogDescription> : null}
              </div>
            </div>
          ) : (
            <>
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : null}
            </>
          )}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
