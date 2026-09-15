## 来源

摘自《TypeScript 教程》，作者阮一峰，仅供个人学习使用。
原文：https://github.com/wangdoc/typescript-tutorial

---

# TypeScript 泛型

## 简介

有些时候，函数返回值的类型与参数类型是相关的。

```javascript
function getFirst(arr) {
  return arr[0];
}
```

上面示例中，函数`getFirst()`总是返回参数数组的第一个成员。参数数组是什么类型，返回值就是什么类型。

这个函数的类型声明只能写成下面这样。

```typescript
function f(arr:any[]):any {
  return arr[0];
}
```

上面的类型声明，就反映不出参数与返回值之间的类型关系。

为了解决这个问题，TypeScript 就引入了“泛型”（generics）。泛型的特点就是带有“类型参数”（type parameter）。

```typescript
function getFirst<T>(arr:T[]):T {
  return arr[0];
}
```

上面示例中，函数`getFirst()`的函数名后面尖括号的部分`<T>`，就是类型参数，参数要放在一对尖括号（`<>`）里面。本例只有一个类型参数`T`，可以将其理解为类型声明需要的变量，需要在调用时传入具体的参数类型。

上例的函数`getFirst()`的参数类型是`T[]`，返回值类型是`T`，就清楚地表示了两者之间的关系。比如，输入的参数类型是`number[]`，那么 T 的值就是`number`，因此返回值类型也是`number`。

函数调用时，需要提供类型参数。

```typescript
getFirst<number>([1, 2, 3])
```

上面示例中，调用函数`getFirst()`时，需要在函数名后面使用尖括号，给出类型参数`T`的值，本例是`<number>`。

不过为了方便，函数调用时，往往省略不写类型参数的值，让 TypeScript 自己推断。

```typescript
getFirst([1, 2, 3])
```

上面示例中，TypeScript 会从实际参数`[1, 2, 3]`，推断出类型参数 T 的值为`number`。

有些复杂的使用场景，TypeScript 可能推断不出类型参数的值，这时就必须显式给出了。

```typescript
function comb<T>(arr1:T[], arr2:T[]):T[] {
  return arr1.concat(arr2);
}
```

