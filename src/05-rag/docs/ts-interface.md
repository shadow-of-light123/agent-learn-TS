## 来源

摘自《TypeScript 教程》，作者阮一峰，仅供个人学习使用。
原文：https://github.com/wangdoc/typescript-tutorial

---

# TypeScript 的 interface 接口

## 简介

interface 是对象的模板，可以看作是一种类型约定，中文译为“接口”。使用了某个模板的对象，就拥有了指定的类型结构。

```typescript
interface Person {
  firstName: string;
  lastName: string;
  age: number;
}
```

上面示例中，定义了一个接口`Person`，它指定一个对象模板，拥有三个属性`firstName`、`lastName`和`age`。任何实现这个接口的对象，都必须部署这三个属性，并且必须符合规定的类型。

实现该接口很简单，只要指定它作为对象的类型即可。

```typescript
const p:Person = {
  firstName: 'John',
  lastName: 'Smith',
  age: 25
};
```

上面示例中，变量`p`的类型就是接口`Person`，所以必须符合`Person`指定的结构。

方括号运算符可以取出 interface 某个属性的类型。

```typescript
interface Foo {
  a: string;
}

type A = Foo['a']; // string
```

上面示例中，`Foo['a']`返回属性`a`的类型，所以类型`A`就是`string`。

interface 可以表示对象的各种语法，它的成员有5种形式。

- 对象属性
- 对象的属性索引
- 对象方法
- 函数
- 构造函数

（1）对象属性

```typescript
interface Point {
  x: number;
  y: number;
}
```

上面示例中，`x`和`y`都是对象的属性，分别使用冒号指定每个属性的类型。
