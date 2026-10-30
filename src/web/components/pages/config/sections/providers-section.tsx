import type { ConfigSchemaType } from "@core/validations/config";
import { ProviderCard } from "../providers/provider-card";
import { useTranslations } from "use-intl";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useFormContext } from "react-hook-form";

type Provider = ConfigSchemaType["providers"][number];
type ProviderType = Provider["type"];

// Every provider type starts from a template; URLs are always typed in by hand.
const BESPOKE_TEMPLATES: Partial<Record<ProviderType, () => Provider>> = {
  newapi: () => ({
    type: "newapi",
    name: "",
    baseUrl: "",
    systemAccessToken: "",
    userId: 1,
  }),
  nvidia: () => ({
    type: "nvidia",
    name: "",
    apiKey: "",
    baseUrl: "",
    imageBaseUrl: "",
  }),
  openrouter: () => ({ type: "openrouter", name: "", apiKey: "", baseUrl: "" }),
  "openai-compatible": () => ({
    type: "openai-compatible",
    name: "",
    apiKey: "",
    baseUrl: "",
  }),
  comfyui: () => ({
    type: "comfyui",
    name: "",
    apiKey: "",
    provider: "runpod",
    baseUrl: "",
    templates: {},
  }),
};

function templateFor(type: ProviderType): Provider {
  const bespoke = BESPOKE_TEMPLATES[type];
  if (bespoke) return bespoke();
  return { type, name: "", apiKey: "" } as Provider;
}

const TYPE_ORDER: ProviderType[] = [
  "newapi",
  "nvidia",
  "openrouter",
  "openai-compatible",
  "comfyui",
] as ProviderType[];

export function ProvidersSection() {
  const t = useTranslations();
  const form = useFormContext<ConfigSchemaType>();
  const providers = useFieldArray({
    control: form.control,
    name: "providers",
  });
  const [pickOpen, setPickOpen] = useState(false);

  const addProvider = (type: ProviderType) => {
    providers.append(templateFor(type));
    setPickOpen(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("CONFIG.PROVIDERS.TITLE")}</CardTitle>
        <CardDescription>{t("CONFIG.PROVIDERS.DESCRIPTION")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {providers.fields.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("CONFIG.PROVIDERS.EMPTY")}
          </p>
        ) : null}
        {providers.fields.map((field, i) => (
          <ProviderCard
            key={field.id}
            index={i}
            onDelete={() => providers.remove(i)}
          />
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => setPickOpen(true)}
        >
          <PlusIcon />
          {t("CONFIG.PROVIDERS.ADD")}
        </Button>
      </CardContent>

      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("CONFIG.PROVIDERS.PICK_TYPE")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            {TYPE_ORDER.map((type) => (
              <Button
                key={type}
                type="button"
                variant="outline"
                onClick={() => addProvider(type)}
                className="justify-start"
              >
                {type}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
