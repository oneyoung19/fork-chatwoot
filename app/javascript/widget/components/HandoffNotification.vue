<script>
export default {
  name: 'HandoffNotification',
  props: {
    message: {
      type: Object,
      default: () => {},
    },
  },
};
</script>

<template>
  <div class="flex justify-center my-3 px-4">
    <div class="px-3 py-1 bg-n-slate-3 dark:bg-n-solid-3 rounded-full max-w-xs">
      <span class="text-xs text-n-slate-11 text-center leading-snug">
        {{ message.content }}
      </span>
    </div>
  </div>
</template>
