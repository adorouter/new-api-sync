import { type ConfigSchemaType } from "@core/validations/config";
import { useTranslations } from "use-intl";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { providerPath } from "./provider-path";
import type { TObject } from "@sinclair/typebox/type";
import { useFormContext } from "react-hook-form";

const variantSchema = { properties: {} } as unknown as TObject;

export function ProviderSimplePanel(props: { index: number }) {
  const t = useTranslations();
  const form = useFormContext<ConfigSchemaType>();
  return (
    <div className="space-y-4">
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "baseUrl")}
        schema={variantSchema}
        label={t("CONFIG.PROVIDER.BASE_URL")}
      />
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "apiKey")}
        schema={variantSchema}
        label={t("CONFIG.PROVIDER.API_KEY")}
        type="password"
      />
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "ratio")}
        schema={variantSchema}
        label={t("CONFIG.PROVIDER.RATIO")}
        type="number"
        step="any"
      />
    </div>
  );
}
