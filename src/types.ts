// src/types.ts
export interface JxaRef {
    __ref: string;
}

export type JxaProxy<T extends object = object> = JxaRef & T;
