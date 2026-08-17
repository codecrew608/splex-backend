"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FakeCheckoutModal } from "./FakeCheckoutModal";

export function UpgradeButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} className="w-full">
        Upgrade to Pro
      </Button>
      {open && <FakeCheckoutModal onClose={() => setOpen(false)} />}
    </>
  );
}
