## 来源

摘自《TypeScript 教程》，作者阮一峰，仅供个人学习使用。
原文：https://github.com/wangdoc/typescript-tutorial

---

# TypeScript 类型缩小

TypeScript 变量的值可以变，但是类型通常是不变的。唯一允许的改变，就是类型缩小，就是将变量值的范围缩得更小。

## 手动类型缩小

如果一个变量属于联合类型，所以使用时一般需要缩小类型。

第一种方法是使用`if`判断。

```typescript
function getScore(value: number|string): number {
  if (typeof value === 'number') { // (A)
    // %inferred-type: number
    value;
    return value;
  }
  if (typeof value === 'string') { // (B)
    // %inferred-type: string
    value;
    return value.length;
  }
  throw new Error('Unsupported value: ' + value);
}
```

如果一个值是`any`或`unknown`，你又想对它进行处理，就必须先缩小类型。

```typescript
function parseStringLiteral(stringLiteral: string): string {
  const result: unknown = JSON.parse(stringLiteral);
  if (typeof result === 'string') { // (A)
    return result;
  }
  throw new Error('Not a string literal: ' + stringLiteral);
}
```

下面是另一个例子。

```typescript
interface Book {
  title: null | string;
  isbn: string;
}

function getTitle(book: Book) {
  if (book.title === null) {
    // %inferred-type: null
    book.title;
    return '(Untitled)';
  } else {
    // %inferred-type: string
    book.title;
    return book.title;
  }
}
```

缩小类型的前提是，需要先获取类型。获取类型的几种方法如下。

```typescript
function func(value: Function|Date|number[]) {
  if (typeof value === 'function') {
    // %inferred-type: Function
    value;
  }

  if (value instanceof Date) {
    // %inferred-type: Date
    value;
  }

  if (Array.isArray(value)) {
    // %inferred-type: number[]
    value;
  }
}
```

