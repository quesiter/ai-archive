type SourceDeviceMetadata = {
  sourceDeviceName?: unknown;
  sourceDevice?: { name?: unknown } | null;
  adapterVersion?: unknown;
  triggerReason?: unknown;
};

export function sourceDeviceLabel(value: SourceDeviceMetadata | null | undefined): string {
  if (typeof value?.sourceDeviceName === "string") return value.sourceDeviceName;
  if (typeof value?.sourceDevice?.name === "string") return value.sourceDevice.name;
  if (value?.triggerReason === "historical_import" || value?.adapterVersion === "chat-memo-text-v1") {
    return "历史文件导入";
  }
  return "未记录设备";
}

export function sourceDeviceFilterLabel(key: string): string {
  if (key === "historical_import") return "历史文件导入";
  if (key === "unrecorded") return "未记录设备";
  return key.startsWith("name:") ? key.slice(5) : key;
}
